import React from "react";

export class Legacy extends React.Component<{ title: string }> {
  render() {
    return <h1>{this.props.title}</h1>;
  }
}
