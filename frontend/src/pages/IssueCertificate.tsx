import { useState, useEffect } from 'react';
import { Award, Eye, Layout, XCircle } from 'lucide-react';
import { createCertificate, fetchDefaultTemplate, fetchUserByEmail, templateApi, CertificateTemplate } from '../api';
import CertificatePreviewModal, { CertificatePreviewData } from '../components/CertificatePreviewModal';
import { useAuth } from '../context/AuthContext';

const GRADE_OPTIONS = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F', 'Pass', 'Distinction', 'Merit'];

interface IssueCertificateFormData {
  recipientName: string;
  recipientEmail: string;
  courseName: string;
  issuerName: string;
  grade: string;
  issueDate: string;
  expiryDate: string;
  templateId: string;
}

const formatPreviewDate = (value: string) => {
  if (!value) {
    return '';
  }

  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

const IssueCertificate = () => {
  const { user } = useAuth();
  const initialFormData: IssueCertificateFormData = {
    recipientName: '',
    recipientEmail: '',
    courseName: '',
    issuerName: '',
    grade: '',
    issueDate: '',
    expiryDate: '',
    templateId: ''
  };
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [templates, setTemplates] = useState<CertificateTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
const [templatesError, setTemplatesError] = useState('');
  const [formData, setFormData] = useState<IssueCertificateFormData>(initialFormData);

  useEffect(() => {
    if (user) {
      const fullName = ('firstName' in user && 'lastName' in user)
        ? `${(user as { firstName: string }).firstName} ${(user as { lastName: string }).lastName}`.trim()
        : ('name' in user ? (user as { name: string }).name : '');
      setFormData(prev => ({ ...prev, issuerName: fullName }));
    }
  }, [user]);

  useEffect(() => {
    const loadTemplates = async () => {
      setTemplatesLoading(true);
      setTemplatesError('');
      try {
        const [allTemplates, defaultTemplate] = await Promise.all([
          templateApi.list(),
          fetchDefaultTemplate(),
        ]);
        setTemplates(allTemplates);
        if (defaultTemplate) {
          setFormData((prev) =>
            prev.templateId ? prev : { ...prev, templateId: defaultTemplate.id }
          );
        }
      } catch (err) {
        console.error('Failed to load templates:', err);
        setTemplatesError('Failed to load templates. Please refresh the page.');
      } finally {
        setTemplatesLoading(false);
      }
    };
    loadTemplates();
  }, []);

  const selectedTemplate = templates.find((template) => template.id === formData.templateId);

  const previewData: CertificatePreviewData = {
    recipientName: formData.recipientName,
    recipientEmail: formData.recipientEmail,
    courseName: formData.courseName,
    issuerName: formData.issuerName,
    grade: formData.grade,
    issueDate: formData.issueDate,
    expiryDate: formData.expiryDate || undefined,
    templateName: selectedTemplate?.name,
  };
  const validateForm = (): string | null => {
    const namePattern = /\S/;
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
    if (!formData.recipientName.trim() || formData.recipientName.trim().length < 2) {
      return 'Recipient name must be at least 2 characters.';
    }
    if (!namePattern.test(formData.recipientName)) {
      return 'Recipient name must contain valid characters.';
    }
    if (!emailPattern.test(formData.recipientEmail)) {
      return 'Please enter a valid email address.';
    }
    if (!formData.courseName.trim() || formData.courseName.trim().length < 3) {
      return 'Course name must be at least 3 characters.';
    }
    if (!formData.issuerName.trim() || formData.issuerName.trim().length < 2) {
      return 'Issuer name must be at least 2 characters.';
    }
    if (!formData.grade) {
      return 'Please select a grade.';
    }
    if (!formData.issueDate) {
      return 'Please select an issue date.';
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const issueDate = new Date(`${formData.issueDate}T00:00:00`);
    if (issueDate > today) {
      return 'Issue date cannot be in the future.';
    }
    if (formData.expiryDate) {
      const expiryDate = new Date(`${formData.expiryDate}T00:00:00`);
      if (expiryDate <= issueDate) {
        return 'Expiry date must be after the issue date.';
      }
    }
    if (!formData.templateId) {
      return 'Please select a template.';
    }
    return null;
  };
  
  const handleOpenPreview = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setIsPreviewOpen(true);
  };

  const handleConfirmIssue = async () => {
    try {
      if (!user) {
        setError("You must be logged in to issue a certificate.");
        return;
      }

      setIsSubmitting(true);
      setError('');

      // Fetch recipient details
      const recipient = await fetchUserByEmail(formData.recipientEmail);
      // Use selected templateId if available, otherwise fetch default as fallback
      const templateId = formData.templateId || (await fetchDefaultTemplate())?.id;

      if (!recipient) {
        setError("Failed to fetch recipient details. Please Recheck Email");
        return;
      }

      if (!templateId) {
        setError("Please select a template.");
        return;
      }

      const issuerId = user.id;

      const certificateData = {
        title: `${formData.courseName} Certificate`,
        description: `This certificate is awarded for completing the ${formData.courseName} course`,
        courseName: formData.courseName,
        issuerName: formData.issuerName,
        recipientName: formData.recipientName,
        recipientEmail: formData.recipientEmail,
        issueDate: formData.issueDate,
        expiryDate: formData.expiryDate || undefined,
        issuerId,
        recipientId: recipient.id,
        templateId: templateId,
        metadata: {
          grade: formData.grade,
          courseName: formData.courseName
        }
      };

      console.log('Request Payload:', certificateData);
      const res = await createCertificate(certificateData);

      if (!res) {
        setError("Failed to create Certificate");
        return;
      }
      setIsPreviewOpen(false);
      setFormData({
        ...initialFormData,
        issuerName: formData.issuerName,
        templateId: formData.templateId
      });
      setError('');
    } catch (error: unknown) {
      console.error('Error issuing certificate:', error);
      setError(error instanceof Error ? error.message : 'Failed to issue certificate');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <Award className="w-10 h-10 text-blue-600" />
        <h1 className="text-3xl font-bold">Issue Certificate</h1>
      </div>

      <div className="bg-white rounded-lg shadow-md p-6">
        <form onSubmit={handleOpenPreview} className="space-y-6">
        <div>
  <label className="block text-sm font-medium text-gray-700 mb-1">
    <div className="flex items-center gap-2">
      <Layout className="w-4 h-4" />
      Certificate Template
    </div>
  </label>
  {templatesLoading ? (
    <div className="w-full px-4 py-2 border rounded-md bg-gray-50 text-gray-400 text-sm">
      Loading templates…
    </div>
  ) : templatesError ? (
    <div className="flex items-center gap-2 text-red-600 text-sm mt-1">
      <XCircle className="w-4 h-4 flex-shrink-0" />
      <span>{templatesError}</span>
    </div>
  ) : (
    <select
      value={formData.templateId}
      onChange={(e) => setFormData({ ...formData, templateId: e.target.value })}
      className="w-full px-4 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500 bg-white"
      required
    >
      <option value="" disabled>Select a template</option>
      {templates.map((template) => (
        <option key={template.id} value={template.id}>
          {template.name}
        </option>
      ))}
    </select>
  )}
</div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Recipient Email</label>
            <input
              type="email"
              value={formData.recipientEmail}
              onChange={(e) => setFormData({ ...formData, recipientEmail: e.target.value })}
              className="w-full px-4 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Issuer Name</label>
            <input
              type="text"
              value={formData.issuerName}
              onChange={(e) => setFormData({ ...formData, issuerName: e.target.value })}
              className="w-full px-4 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Course Name</label>
            <input
              type="text"
              value={formData.courseName}
              onChange={(e) => setFormData({ ...formData, courseName: e.target.value })}
              className="w-full px-4 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Grade / Achievement Level</label>
            <select
              value={formData.grade}
              onChange={(e) => setFormData({ ...formData, grade: e.target.value })}
              className="w-full px-4 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500 bg-white"
              required
            >
              <option value="" disabled>Select a grade</option>
              {GRADE_OPTIONS.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Issue Date</label>
            <input
              type="date"
              value={formData.issueDate}
              onChange={(e) => setFormData({ ...formData, issueDate: e.target.value })}
              className="w-full px-4 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <div className="flex items-center gap-2">
                <Layout className="w-4 h-4" />
                Certificate Template
              </div>
            </label>
            <select
              value={formData.templateId}
              onChange={(e) => setFormData({ ...formData, templateId: e.target.value })}
              className="w-full px-4 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500 bg-white"
              required
            >
              <option value="" disabled>Select a template</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Expiry Date (Optional)</label>
            <input
              type="date"
              value={formData.expiryDate}
              onChange={(e) => setFormData({ ...formData, expiryDate: e.target.value })}
              className="w-full px-4 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
            {error && (
            <div className="flex items-center gap-2 text-red-600 mb-4">
              <XCircle className="w-5 h-5" />
              <p>{error}</p>
            </div>
          )}

          <div className="flex items-center justify-between pt-4">
            <button
              type="submit"
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-2"
            >
              <Eye className="w-4 h-4" />
              Preview Certificate
            </button>
          </div>
        </form>
        <div className="mt-6 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900">
          <p className="font-medium">Preview before issuance</p>
          <p className="mt-1 text-blue-800">
            You will review recipient details, course name, template, and dates before the certificate is submitted.
          </p>
          {formData.issueDate && (
            <p className="mt-2 text-blue-700">
              Current draft issue date: {formatPreviewDate(formData.issueDate)}
            </p>
          )}
        </div>
      </div>

      <CertificatePreviewModal
        isOpen={isPreviewOpen}
        preview={previewData}
        isSubmitting={isSubmitting}
        onClose={() => setIsPreviewOpen(false)}
        onConfirm={handleConfirmIssue}
      />
    </div>
  );
};

export default IssueCertificate;
