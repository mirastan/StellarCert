it(
  'generates stellar keypair',
  async () => {
    render(
      <IssuerProfile />,
    );

    await user.click(
      screen.getByRole(
        'button',
        {
          name:
            /generate stellar keypair/i,
        },
      ),
    );

    expect(
      screen.getByDisplayValue(/^G/)
    ).toBeInTheDocument();
  },
);